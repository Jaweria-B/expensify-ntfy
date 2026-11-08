// Checks Expensify/App and paid open-source bounties, and sends ntfy alerts. Kept free of Cloudflare-only imports so it
// can be tested with plain Node.

const REPO_OWNER = 'Expensify';
const REPO_NAME = 'App';
const HELP_WANTED = 'Help Wanted';
const EXTERNAL = 'External';
const BOUNTY = '💎 Bounty';

// GitHub organizations whose Algora bounties have actually been paid ("💰 Rewarded") in 2026. Any repo can put a
// "💎 Bounty" label on its own issues, so watching only proven payers keeps out label-only "bounties" that never pay.
// Replace the list with a BOUNTY_ORGS secret (comma-separated, e.g. "calcom,activepieces") without editing code.
const DEFAULT_BOUNTY_ORGS = [
    'calcom',
    'activepieces',
    'CapSoftware',
    'permitio',
    'qdrant',
    'archestra-ai',
    'highlight',
    'screenpipe',
    'tursodatabase',
    'golemcloud',
    'projectdiscovery',
    'tscircuit',
];
const ERROR_ALERT_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Durable Object storage reads and writes at most 128 keys per call.
const STORAGE_BATCH_SIZE = 128;

const LABELED_EVENTS = 'timelineItems(last: 10, itemTypes: [LABELED_EVENT]) { nodes { ... on LabeledEvent { createdAt label { name } } } }';

// GraphQL asks for only the fields the alerts use, which keeps each run small and fast.
const QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    helpWanted: issues(first: 100, states: OPEN, labels: [${JSON.stringify(HELP_WANTED)}], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { number title url comments { totalCount } ${LABELED_EVENTS} }
    }
    external: issues(first: 100, states: OPEN, labels: [${JSON.stringify(EXTERNAL)}], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number title url comments { totalCount } labels(first: 30) { nodes { name } } ${LABELED_EVENTS} }
    }
  }
}`;

// Open bounty issues across the watched organizations. The first few comments are read to find the amount the Algora
// bot posts ("💎 $100 bounty").
const BOUNTY_QUERY = `query($search: String!) {
  search(query: $search, type: ISSUE, first: 50) {
    nodes {
      ... on Issue {
        number title url
        repository { nameWithOwner }
        comments { totalCount }
        firstComments: comments(first: 5) { nodes { author { login } body } }
        labels(first: 30) { nodes { name } }
        ${LABELED_EVENTS}
      }
    }
  }
}`;

async function queryGitHub(env, query, variables) {
    if (!env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN secret is not set');
    }
    const response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            'Content-Type': 'application/json',
            'User-Agent': 'expensify-help-wanted-watcher',
        },
        body: JSON.stringify({query, variables}),
    });
    if (!response.ok) {
        throw new Error(`GitHub returned HTTP ${response.status}`);
    }
    const body = await response.json();
    if (body.errors?.length) {
        throw new Error(`GitHub error: ${body.errors[0].message}`);
    }
    return body.data;
}

async function fetchIssues(env) {
    const repository = (await queryGitHub(env, QUERY, {owner: REPO_OWNER, name: REPO_NAME}))?.repository;
    if (!repository) {
        throw new Error('GitHub returned no repository data');
    }
    return repository;
}

function getBountyOrgs(env) {
    const fromSecret = (env.BOUNTY_ORGS ?? '')
        .split(',')
        .map((org) => org.trim())
        .filter(Boolean);
    return fromSecret.length > 0 ? fromSecret : DEFAULT_BOUNTY_ORGS;
}

/** Open bounty issues in the watched organizations, newest first. */
async function fetchBounties(env) {
    const orgs = getBountyOrgs(env);
    const search = `is:issue is:open label:${JSON.stringify(BOUNTY)} sort:created-desc ${orgs.map((org) => `org:${org}`).join(' ')}`;
    const result = (await queryGitHub(env, BOUNTY_QUERY, {search}))?.search;
    if (!result) {
        throw new Error('GitHub returned no bounty search data');
    }
    // A search result that is not an issue comes back as an empty object.
    return {orgs, issues: result.nodes.filter((issue) => issue?.number !== undefined)};
}

async function notify(env, {title, message, url, priority, tags}) {
    if (!env.NTFY_TOPIC) {
        throw new Error('NTFY_TOPIC secret is not set');
    }
    const response = await fetch(env.NTFY_SERVER || 'https://ntfy.sh', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({topic: env.NTFY_TOPIC, title, message, click: url, priority, tags}),
    });
    if (!response.ok) {
        throw new Error(`ntfy returned HTTP ${response.status}`);
    }
}

/** When the label was last added, or undefined if that was too long ago to show in the issue's recent label events. */
function getLabeledAt(issue, labelName) {
    return (issue.timelineItems?.nodes ?? [])
        .filter((event) => event?.label?.name === labelName)
        .map((event) => event.createdAt)
        .sort()
        .at(-1);
}

function getLabeledText(labeledAt) {
    if (!labeledAt) {
        return '';
    }
    return `, labeled ${Math.max(0, Math.round((Date.now() - Date.parse(labeledAt)) / 60000))} min ago`;
}

function helpWantedAlert(issue, labeledAt, titlePrefix = '') {
    const price = issue.title.match(/\[\$(\d[\d,]*)\]/)?.[1];
    return {
        title: `${titlePrefix}${HELP_WANTED}: #${issue.number}${price ? ` ($${price})` : ''}`,
        message: `${issue.title}\n${issue.comments.totalCount} comments so far${getLabeledText(labeledAt)}`,
        url: issue.url,
        priority: 5,
        tags: ['rotating_light'],
    };
}

/** The bounty amount, from a "$100" label or the Algora bot's comment, or undefined when neither shows one. */
function getBountyAmount(issue) {
    const amountLabel = issue.labels.nodes.find((label) => /^\$\d/.test(label.name))?.name;
    if (amountLabel) {
        return amountLabel;
    }
    const botComment = issue.firstComments.nodes.find((comment) => comment?.author?.login?.toLowerCase().includes('algora'));
    const amount = botComment?.body.match(/\$\s?(\d[\d,]*)/)?.[1];
    return amount ? `$${amount}` : undefined;
}

function bountyAlert(issue, labeledAt, titlePrefix = '') {
    const amount = getBountyAmount(issue);
    return {
        title: `${titlePrefix}Bounty: ${issue.repository.nameWithOwner}#${issue.number}${amount ? ` (${amount})` : ''}`,
        message: `${issue.title}\n${issue.comments.totalCount} comments so far${getLabeledText(labeledAt)}. Check the /attempt comments before starting.`,
        url: issue.url,
        priority: 4,
        tags: ['gem'],
    };
}

function headsUpAlert(issue) {
    return {
        title: `Heads-up: #${issue.number} is ${EXTERNAL}`,
        message: `${issue.title}\nNot open for proposals yet. Prepare now, and post only after ${HELP_WANTED} is added.`,
        url: issue.url,
        priority: 3,
        tags: ['eyes'],
    };
}

async function getMany(storage, keys) {
    const found = new Map();
    for (let i = 0; i < keys.length; i += STORAGE_BATCH_SIZE) {
        for (const [key, value] of await storage.get(keys.slice(i, i + STORAGE_BATCH_SIZE))) {
            found.set(key, value);
        }
    }
    return found;
}

async function putMany(storage, entries) {
    for (let i = 0; i < entries.length; i += STORAGE_BATCH_SIZE) {
        await storage.put(Object.fromEntries(entries.slice(i, i + STORAGE_BATCH_SIZE)));
    }
}

/**
 * The bounty alerts that are due. Bounties have their own start time, so turning the bounty watch on (or updating an
 * existing watcher) never alerts about bounties that were already open.
 */
async function getDueBounties(storage, env, now) {
    const {orgs, issues} = await fetchBounties(env);

    let bountyInstalledAt = await storage.get('bountyInstalledAt');
    if (bountyInstalledAt === undefined) {
        await notify(env, {
            title: 'Bounty watch is on',
            message: `Watching ${orgs.length} organizations that have paid bounties before (${issues.length} bounties open now). You will be alerted about new ones from now on.`,
            url: `https://github.com/search?q=${encodeURIComponent(`is:issue is:open label:"${BOUNTY}" ${orgs.map((org) => `org:${org}`).join(' ')}`)}&type=issues&s=created&o=desc`,
            priority: 3,
            tags: ['gem'],
        });
        bountyInstalledAt = now;
        await storage.put('bountyInstalledAt', bountyInstalledAt);
    }

    const due = [];
    for (const issue of issues) {
        const labeledAt = getLabeledAt(issue, BOUNTY);
        if (labeledAt && Date.parse(labeledAt) > bountyInstalledAt) {
            due.push({key: `sent:bounty:${issue.repository.nameWithOwner}#${issue.number}:${labeledAt}`, labeledAt, alert: bountyAlert(issue, labeledAt)});
        }
    }
    return due;
}

/**
 * Sends every alert that is due and returns the errors of any that failed.
 *
 * Each alert is identified by its issue and the time its label was added, and is recorded the moment it is sent.
 * So a failure only means that one alert is tried again on the next run; an alert that went out never repeats.
 */
async function runCheck(storage, env) {
    const {helpWanted, external} = await fetchIssues(env);
    const now = Date.now();

    let installedAt = await storage.get('installedAt');
    if (installedAt === undefined) {
        await notify(env, {
            title: 'Expensify watcher is running',
            message: `Watching ${helpWanted.nodes.length} open ${HELP_WANTED} issues. You will be alerted about new ones from now on.`,
            url: `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues?q=is%3Aopen+label%3A%22Help+Wanted%22`,
            priority: 3,
            tags: ['white_check_mark'],
        });
        installedAt = now;
        await storage.put('installedAt', installedAt);
    }

    // Remember every issue that was ever Help Wanted, so losing the label later does not send a heads-up for it.
    const helpWantedNumbers = new Set(helpWanted.nodes.map((issue) => issue.number));
    const everHelpWantedKeys = helpWanted.nodes.map((issue) => `everHelpWanted:${issue.number}`);
    const everHelpWanted = await getMany(storage, [...everHelpWantedKeys, ...external.nodes.map((issue) => `everHelpWanted:${issue.number}`)]);
    await putMany(
        storage,
        everHelpWantedKeys.filter((key) => !everHelpWanted.has(key)).map((key) => [key, now]),
    );

    // Only labels added after installation count, so issues that were already open never alert.
    const isNew = (labeledAt) => !!labeledAt && Date.parse(labeledAt) > installedAt;
    const due = [];
    for (const issue of helpWanted.nodes) {
        const labeledAt = getLabeledAt(issue, HELP_WANTED);
        if (isNew(labeledAt)) {
            due.push({key: `sent:helpWanted:${issue.number}:${labeledAt}`, labeledAt, alert: helpWantedAlert(issue, labeledAt)});
        }
    }
    for (const issue of external.nodes) {
        const labeledAt = getLabeledAt(issue, EXTERNAL);
        const isPending = !issue.labels.nodes.some((label) => label.name === HELP_WANTED);
        if (isPending && isNew(labeledAt) && !helpWantedNumbers.has(issue.number) && !everHelpWanted.has(`everHelpWanted:${issue.number}`)) {
            due.push({key: `sent:external:${issue.number}:${labeledAt}`, labeledAt, alert: headsUpAlert(issue)});
        }
    }

    // Bounties are checked separately, so a failed bounty search never blocks the Expensify alerts above.
    const failures = [];
    try {
        due.push(...(await getDueBounties(storage, env, now)));
    } catch (error) {
        failures.push(new Error(`Bounty check failed: ${error.message}`));
    }

    const alreadySent = await getMany(
        storage,
        due.map(({key}) => key),
    );
    for (const {key, alert} of due.filter(({key}) => !alreadySent.has(key)).sort((a, b) => a.labeledAt.localeCompare(b.labeledAt))) {
        try {
            await notify(env, alert);
            await storage.put(key, now);
        } catch (error) {
            failures.push(error);
        }
    }
    return failures;
}

async function reportError(storage, env, error) {
    console.error(error);
    const lastErrorAlertAt = await storage.get('lastErrorAlertAt');
    if (lastErrorAlertAt && Date.now() - lastErrorAlertAt < ERROR_ALERT_INTERVAL_MS) {
        return;
    }
    try {
        await notify(env, {
            title: 'Expensify watcher error',
            message: `${error.message}\nIt will keep retrying every 10 minutes. You will get at most one of these every 6 hours.`,
            url: 'https://dash.cloudflare.com/',
            priority: 4,
            tags: ['warning'],
        });
        await storage.put('lastErrorAlertAt', Date.now());
    } catch (notifyError) {
        console.error(notifyError);
    }
}

async function checkAndReport(storage, env) {
    let failures;
    try {
        failures = await runCheck(storage, env);
    } catch (error) {
        failures = [error];
    }
    if (failures.length > 0) {
        await reportError(storage, env, failures[0]);
    }
}

/** Sends a test alert for the newest open bounty in the watched organizations. */
async function sendBountyTest(env) {
    const {orgs, issues} = await fetchBounties(env);
    const newest = issues
        .map((issue) => ({issue, labeledAt: getLabeledAt(issue, BOUNTY)}))
        .sort((a, b) => (b.labeledAt ?? '').localeCompare(a.labeledAt ?? ''))
        .at(0);
    await notify(
        env,
        newest
            ? bountyAlert(newest.issue, newest.labeledAt, '[TEST] ')
            : {title: '[TEST] Bounty watch is working', message: `No open bounties in the ${orgs.length} watched organizations right now.`, priority: 3},
    );
}

/** Sends a test alert for the issue that most recently got Help Wanted, or for the newest bounty when asked. */
async function sendTest(env, type) {
    if (type === 'bounty') {
        await sendBountyTest(env);
        return;
    }
    const {helpWanted} = await fetchIssues(env);
    const newest = helpWanted.nodes
        .map((issue) => ({issue, labeledAt: getLabeledAt(issue, HELP_WANTED)}))
        .sort((a, b) => (b.labeledAt ?? '').localeCompare(a.labeledAt ?? ''))
        .at(0);
    await notify(
        env,
        newest
            ? helpWantedAlert(newest.issue, newest.labeledAt, '[TEST] ')
            : {title: '[TEST] Watcher is working', message: `No open ${HELP_WANTED} issues right now.`, url: `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues`, priority: 3},
    );
}

export {checkAndReport, sendTest};
