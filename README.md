# looot-action

A GitHub Action that runs one [looot](https://looot.ai) operation from a workflow and gives you the result as JSON. looot is one token and one prepaid balance for 2,500+ data API endpoints: work emails, company and people search, Google results, web pages, news. You pay per call, the price is known before the run, and a failed call costs nothing.

Typical uses: a weekly Google ranking snapshot, verifying an email list in CI, enriching a row when a file changes.

## Use

1. Create an agent token at https://looot.ai (Settings, Agent tokens) with the scopes `catalog.read`, `runs.read`, `runs.execute` and `usage.read`, and top up your balance (from $5).
2. Add it as the repository secret `LOOOT_TOKEN`.
3. Add a step:

```yaml
- id: serp
  uses: loootai/looot-action@v0.1.0   # pin to a commit SHA in production
  with:
    operation-id: job:google.serp.organic
    input-json: '{"query": "best crm for startups", "country": "us"}'
    max-cost-usd: "0.05"
    token: ${{ secrets.LOOOT_TOKEN }}

- run: echo "$RESULT" | jq '.'
  env:
    RESULT: ${{ steps.serp.outputs.result }}
```

Full workflows are in [examples/](examples/): a weekly SERP snapshot and a manual email check.

To find an `operation-id`, search the catalog (free) with the [CLI](https://www.npmjs.com/package/looot), the MCP server, or the public list at https://api.looot.ai/v1/public-catalog. An id is either an endpoint such as `serper-search`, or a job such as `job:people.email.find` where looot picks the provider. Jobs take shared input names (`email`, `domain`, `first_name`, `last_name`, `url`, `linkedin_url`...), see https://docs.looot.ai/concepts/job-inputs.

## Inputs

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `operation-id` | yes | | Endpoint id or `job:<id>` |
| `input-json` | no | `{}` | JSON object with the operation input |
| `token` | no | env `LOOOT_TOKEN` | Agent token. Pass `${{ secrets.LOOOT_TOKEN }}` |
| `max-cost-usd` | no | none | Cap for the whole fallback route of a job run |
| `fallback` | no | `auto` | `true`, `false`, or `auto` (on for `job:` ids). A miss moves to the job's next provider inside one hold |
| `wait-seconds` | no | `30` | How long looot holds the request open, 0 to 60 |
| `timeout-seconds` | no | `120` | Total wait, including polling a run that is still going |
| `idempotency-key` | no | per workflow run and input | Same key and same input never charges twice |
| `fail-on-error` | no | `true` | Fail the step when the run does not complete |
| `base-url` | no | `https://api.looot.ai` | Change only if looot gave you another gateway |

## Outputs

| Output | Meaning |
| --- | --- |
| `result` | The run result as JSON |
| `run` | The whole run object: `status`, `result`, `actualCost`, `error` |
| `run-id` | looot run id |
| `status` | `completed`, `failed`, `blocked`... |
| `cost-usd` | What the run cost |
| `result-file` | Path of a file with the full run JSON |

`result` and `run` are empty when the run JSON is over 900 KB (a step output limit); read `result-file` then. The step also writes a one-line table to the job summary.

## Money and safety

- A run is `POST https://api.looot.ai/v1/runs?wait=<n>`; the job result is read back with `GET /v1/runs/{id}` if it is still going after `wait-seconds`.
- The default idempotency key is `gha-<run id>-<hash of operation and input>`. Re-running failed jobs in the same workflow run does not pay twice. A new scheduled run gets a new key, so a weekly job fetches fresh data.
- The token is masked in the logs. Pass it from a secret, never as plain text, and do not run this action on `pull_request` events from forks (secrets are not available there, and you should not want them to be).
- Your prepaid balance is the hard limit. Spend caps and per-token scopes are set in the looot dashboard.

## Develop

```bash
npm test                      # 8 tests: the script runs against a local mock server
bash scripts/leak-scan.sh .   # before every push
```

The action is composite: `action.yml` maps inputs to `LOOOT_INPUT_*` variables and runs `run.mjs` (Node 20 or newer, which hosted runners have). No dependencies, no build step, nothing to bundle.

## Publish to the Marketplace (maintainers)

Create a release of this repo, tick "Publish this Action to the GitHub Marketplace", accept the terms. Needs a GitHub account with 2FA, so it is a manual step. Keep a moving major tag if you want `@v0` style references.

## License

MIT. Docs: https://docs.looot.ai. Support: https://looot.ai/contact.
