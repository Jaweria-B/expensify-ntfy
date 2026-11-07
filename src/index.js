// Alerts your phone through ntfy when an Expensify/App issue gets the "Help Wanted" label, and sends a
// quieter heads-up when an issue is marked "External" but is not open for proposals yet.
// Runs every minute on Cloudflare's free Workers plan.

const REPO_OWNER = 'Expensify';
const REPO_NAME = 'App';
const HELP_WANTED = 'Help Wanted';
const EXTERNAL = 'External';
const STATE_KEY = 'state';
const MAX_REMEMBERED_ISSUES = 1000;
const ERROR_ALERT_INTERVAL_MS = 6 * 60 * 60 * 1000;

// GraphQL asks for only the fields the alerts use, which keeps each run small and fast.
const QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    helpWanted: issues(first: 100, states: OPEN, labels: [${JSON.stringify(HELP_WANTED)}], orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage }
      nodes {
        number
        title
        url
        comments { totalCount }
        timelineItems(last: 10, itemTypes: [LABELED_EVENT]) { nodes { ... on LabeledEvent { createdAt label { name } } } }
      }
    }
    external: issues(first: 100, states: OPEN, labels: [${JSON.stringify(EXTERNAL)}], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        comments { totalCount }
        labels(first: 30) { nodes { name } }
      }
    }
  }
}`;

async function fetchIssues(env) {
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
        body: JSON.stringify({query: QUERY, variables: {owner: REPO_OWNER, name: REPO_NAME}}),
    });
    if (!response.ok) {
        throw new Error(`GitHub returned HTTP ${response.status}`);
    }
    const body = await response.json();
    if (body.errors?.length) {
        throw new Error(`GitHub error: ${body.errors[0].message}`);
    }
    const repository = body.data?.repository;
    if (!repository) {
        throw new Error('GitHub returned no repository data');
    }
    return repository;
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

function getLabeledAt(issue) {
    return (issue.timelineItems?.nodes ?? [])
        .filter((event) => event?.label?.name === HELP_WANTED)
        .map((event) => event.createdAt)
        .sort()
        .at(-1);
}

function helpWantedAlert(issue, titlePrefix = '') {
    const price = issue.title.match(/\[\$(\d[\d,]*)\]/)?.[1];
    const labeledAt = getLabeledAt(issue);
    const minutes = labeledAt ? Math.max(0, Math.round((Date.now() - Date.parse(labeledAt)) / 60000)) : undefined;
    return {
        title: `${titlePrefix}${HELP_WANTED}: #${issue.number}${price ? ` ($${price})` : ''}`,
        message: `${issue.title}\n${issue.comments.totalCount} comments so far${minutes === undefined ? '' : `, labeled ${minutes} min ago`}`,
        url: issue.url,
        priority: 5,
        tags: ['rotating_light'],
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

async function check(env) {
    const state = await env.STATE.get(STATE_KEY, 'json');
    // An error alert can save state before the first successful run, so check for the list itself.
    const isFirstRun = !Array.isArray(state?.helpWanted);
    const previousHelpWanted = new Set(state?.helpWanted ?? []);
    const seen = new Set(state?.seen ?? []);

    const {helpWanted, external} = await fetchIssues(env);
    const currentHelpWanted = helpWanted.nodes.map((issue) => issue.number);

    // An issue alerts again if the label is removed and added back, because it leaves previousHelpWanted in between.
    const newHelpWanted = isFirstRun ? [] : helpWanted.nodes.filter((issue) => !previousHelpWanted.has(issue.number));
    // `seen` also holds every issue that was ever Help Wanted, so losing the label does not trigger a heads-up.
    const pendingExternal = external.nodes.filter((issue) => !issue.labels.nodes.some((label) => label.name === HELP_WANTED));
    const newHeadsUps = isFirstRun ? [] : pendingExternal.filter((issue) => !seen.has(issue.number) && !previousHelpWanted.has(issue.number));

    if (isFirstRun) {
        await notify(env, {
            title: 'Expensify watcher is running',
            message: `Watching ${currentHelpWanted.length} open ${HELP_WANTED} issues. You will be alerted about new ones from now on.`,
            url: `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues?q=is%3Aopen+label%3A%22Help+Wanted%22`,
            priority: 3,
            tags: ['white_check_mark'],
        });
    }
    for (const issue of [...newHelpWanted].reverse()) {
        await notify(env, helpWantedAlert(issue));
    }
    for (const issue of newHeadsUps) {
        await notify(env, headsUpAlert(issue));
    }

    // With more than 100 open Help Wanted issues the list is incomplete, so keep remembered ones instead of dropping them.
    const nextHelpWanted = helpWanted.pageInfo.hasNextPage ? [...new Set([...previousHelpWanted, ...currentHelpWanted])] : currentHelpWanted;
    const nextSeen = [...new Set([...seen, ...currentHelpWanted, ...(isFirstRun ? pendingExternal : newHeadsUps).map((issue) => issue.number)])].slice(-MAX_REMEMBERED_ISSUES);
    const nextState = {helpWanted: nextHelpWanted.sort((a, b) => a - b), seen: nextSeen, lastErrorAlertAt: state?.lastErrorAlertAt};

    // Workers KV allows 1,000 writes a day on the free plan, so only write when something changed.
    if (JSON.stringify(nextState) !== JSON.stringify(state)) {
        await env.STATE.put(STATE_KEY, JSON.stringify(nextState));
    }
}

async function reportError(env, error) {
    console.error(error);
    const state = (await env.STATE.get(STATE_KEY, 'json')) ?? {};
    if (state.lastErrorAlertAt && Date.now() - state.lastErrorAlertAt < ERROR_ALERT_INTERVAL_MS) {
        return;
    }
    try {
        await notify(env, {
            title: 'Expensify watcher error',
            message: `${error.message}\nIt will keep retrying every minute. You will get at most one of these every 6 hours.`,
            url: 'https://dash.cloudflare.com/',
            priority: 4,
            tags: ['warning'],
        });
        await env.STATE.put(STATE_KEY, JSON.stringify({...state, lastErrorAlertAt: Date.now()}));
    } catch (notifyError) {
        console.error(notifyError);
    }
}

export default {
    async scheduled(event, env) {
        try {
            await check(env);
        } catch (error) {
            await reportError(env, error);
        }
    },

    // Visiting /test?key=<TEST_KEY> sends a test alert for the newest Help Wanted issue.
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname !== '/test' || !env.TEST_KEY || url.searchParams.get('key') !== env.TEST_KEY) {
            return new Response('Not found', {status: 404});
        }
        try {
            const {helpWanted} = await fetchIssues(env);
            const newest = [...helpWanted.nodes].sort((a, b) => (getLabeledAt(b) ?? '').localeCompare(getLabeledAt(a) ?? '')).at(0);
            await notify(
                env,
                newest
                    ? helpWantedAlert(newest, '[TEST] ')
                    : {title: '[TEST] Watcher is working', message: `No open ${HELP_WANTED} issues right now.`, url: `https://github.com/${REPO_OWNER}/${REPO_NAME}/issues`, priority: 3},
            );
            return new Response('Test notification sent. Check your phone.');
        } catch (error) {
            return new Response(`Test failed: ${error.message}`, {status: 500});
        }
    },
};
