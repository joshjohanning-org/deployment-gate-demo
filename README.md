# 🔒 Deployment Gate Demo

> Custom Deployment Protection Rule that enforces environment promotion ordering and ServiceNow change ticket validation — **works on ANY workflow, across ANY repo**.

## The Problem

You have 1,500 repos. Every team writes their own CI/CD workflows. You can't build reusable workflows for everyone, but you need to enforce:
- Artifacts must deploy to lower environments before higher ones (Dev → QA → Staging → Prod)
- ServiceNow change tickets are required before production deployments
- A separate team approves production deployments

## The Solution

A **Custom Deployment Protection Rule** — a GitHub App that acts as an automatic gate on environments. Teams use ANY workflow they want; the gate fires automatically when any workflow targets a protected environment.

```
Team writes ANY workflow → deploys to "Production" environment
                                      ↓
              GitHub automatically calls this gate app
                                      ↓
              Gate checks: ✅ Prior env deployed? ✅ Change ticket valid?
                                      ↓
                          Approve or Reject deployment
```

## How It Works

1. **You register this as a GitHub App** on your org
2. **You add it as a deployment protection rule** on environments (Dev, QA, Staging, Production-East, Production-Central)
3. When ANY workflow in ANY repo targets one of those environments, GitHub sends a webhook to this app
4. The app checks:
   - Does the prior environment have a successful deployment? (via GitHub Deployments API)
   - Is a valid ServiceNow change ticket provided? (for production environments)
5. The app responds with **approve** or **reject**

## Environment Hierarchy

Configured in [`config.yml`](config.yml):

```yaml
environments:
  Dev:
    order: 1
    requires_prior: null          # First environment, no gate
    requires_change_ticket: false

  QA:
    order: 2
    requires_prior: Dev           # Must deploy to Dev first
    requires_change_ticket: false

  Staging:
    order: 3
    requires_prior: QA            # Must deploy to QA first
    requires_change_ticket: false

  Production-East:
    order: 4
    requires_prior: Staging       # Must deploy to Staging first
    requires_change_ticket: true  # Requires ServiceNow ticket

  Production-Central:
    order: 4
    requires_prior: Staging
    requires_change_ticket: true
```

## Setup

### 1. Get a smee.io URL

Go to https://smee.io/new and copy the URL. This proxies GitHub webhooks to your local machine.

### 2. Register a GitHub App

Go to your org's settings → Developer settings → GitHub Apps → New GitHub App:

| Setting | Value |
|---|---|
| **Name** | Deployment Gate (or whatever) |
| **Homepage URL** | `https://github.com/your-org/deployment-gate-demo` |
| **Webhook URL** | Your smee.io URL |
| **Webhook Secret** | Generate a random string |
| **Repository permissions** | Actions: Read-only, Deployments: Read and write |
| **Subscribe to events** | ✅ Deployment protection rule |

After creating, download the private key (`.pem` file) and note the App ID.

### 3. Configure the app

```bash
cp .env.example .env
# Edit .env with your values:
#   APP_ID=your-app-id
#   PRIVATE_KEY_PATH=./private-key.pem
#   WEBHOOK_SECRET=your-webhook-secret
#   SMEE_URL=https://smee.io/your-channel
```

### 4. Install the GitHub App

Go to your GitHub App's settings → Install App → install it on your org (or specific repos).

### 5. Enable on environments

For each environment (QA, Staging, Production-East, Production-Central):
- Go to the repo → Settings → Environments → select environment
- Under "Deployment protection rules" → enable your custom gate app

### 6. Run the app

```bash
npm install
npm start
```

The app will:
- Start the Express server on port 3000
- Connect to smee.io to receive forwarded webhooks
- Log all deployment protection rule requests and decisions

## Mock ServiceNow API

The app includes a mock ServiceNow API for demo purposes:

```bash
# Valid ticket (approved)
curl http://localhost:3000/api/servicenow/ticket/CHG0012345

# Any valid format auto-generates an approved ticket
curl http://localhost:3000/api/servicenow/ticket/CHG0054321

# Invalid format
curl http://localhost:3000/api/servicenow/ticket/INVALID
```

## Why This Scales

| Traditional Approach | This Approach |
|---|---|
| Build reusable workflows for every team | Teams use ANY workflow |
| Hope teams include the right checks | Gate fires automatically on environment |
| Enforce via code review of workflows | Enforce via environment protection rules |
| Update 1,500 repos when rules change | Update ONE app when rules change |

## Rollout Strategy

### Phase 1: Deploy the gate app
Host the gate app somewhere persistent (Azure Web App, VM, container, etc.) and point the GitHub App's webhook URL to it. For testing, use smee.io locally.

### Phase 2: Install the GitHub App org-wide
Install the app on the org with access to **all repositories**. The app only activates when an environment has the protection rule attached — installing it does nothing by itself.

### Phase 3: Roll out environments + protection rules
Use the included rollout script to programmatically create environments and attach the gate:

```bash
# Dry run first — see what would happen
./scripts/rollout.sh --dry-run my-repo-1 my-repo-2

# Single repo
./scripts/rollout.sh my-repo

# From a file (one repo name per line)
./scripts/rollout.sh --file repos.txt

# All repos in the org
./scripts/rollout.sh --all
```

The script creates 5 environments per repo (Dev, QA, Staging, Production-East, Production-Central) and attaches the gate to QA, Staging, and Production-*. Production environments also get branch restrictions (only `main` and `v*` tags).

### Phase 4: Communicate to teams
Teams don't need to change their workflows. They just need to use `environment:` in their deploy jobs (which most already do). The gate fires automatically.

### What the rollout script does per repo:

| Environment | Gate Attached | Branch Restriction | Wait Timer |
|---|---|---|---|
| Dev | No | None | No |
| QA | **Yes** (requires Dev) | None | No |
| Staging | **Yes** (requires QA) | None | No |
| Production-East | **Yes** (requires Staging + ticket) | `main` + `v*` tags | 1 min |
| Production-Central | **Yes** (requires Staging + ticket) | `main` + `v*` tags | 1 min |

### Customizing for your org

Edit the `ENVIRONMENTS` array in `scripts/rollout.sh` to match your environment names. Edit `config.yml` to match the hierarchy and ticket requirements.

## Links

- [Creating custom deployment protection rules](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/creating-custom-deployment-protection-rules)
- [Configuring custom deployment protection rules](https://docs.github.com/en/actions/deployment/protecting-deployments/configuring-custom-deployment-protection-rules)
- [Smee.io webhook proxy](https://smee.io)

## FAQ

### Does this require GitHub Releases?

**No.** The gate checks the [GitHub Deployments API](https://docs.github.com/en/rest/deployments/deployments), not releases. Any workflow job that uses `environment: <name>` automatically creates a deployment record tied to that commit SHA. The release-based CD workflow in the demo is just one pattern — teams can use `on: push`, `on: pull_request`, `workflow_dispatch`, or anything else. As long as their deploy job uses `environment:`, the gate works.

### How does the gate know which SHA is being deployed?

The `deployment_protection_rule` webhook payload includes the `deployment.sha` — the exact commit SHA that the workflow is deploying. The gate queries the Deployments API filtered by that SHA:

```
GET /repos/{owner}/{repo}/deployments?environment={prior_env}&sha={current_sha}
```

If the prior environment has no successful deployment **for that exact SHA**, the gate rejects. A different SHA deployed to Dev last week won't satisfy the check for a new SHA deploying to QA today.

### Does a failed deployment count?

**No.** The gate checks the deployment **status**, not just whether a deployment exists. If a deployment to QA failed (e.g., a test failed, a step errored out), the gate will reject promotion to Staging with:

> *"SHA `abc1234` has deployments to 'QA' but none with a success status. The deployment must complete successfully before promotion."*

The artifact must have a **successful** deployment to the prior environment before it can be promoted.

### Where does the ServiceNow ticket come from?

The gate reads the change ticket from the **workflow run's display title**. The demo uses `run-name:` in the workflow to embed the ticket:

```yaml
run-name: "Deploy ${{ inputs.release_tag }} to ${{ inputs.environment }} ${{ inputs.change_ticket }}"
```

The gate scans the display title for a pattern matching `CHG` followed by 7 digits.

### What if a team doesn't add the change_ticket input?

**The deployment to Production gets rejected.** The gate returns:

> *"No ServiceNow change ticket provided. Production deployments require a valid change ticket (e.g., CHG0012345) in the workflow dispatch inputs."*

This is by design — it's self-service enforcement. Teams learn quickly when their first prod deploy fails, and the error message tells them exactly what to add. You can also provide documentation links in the rejection message.

### How can we make ServiceNow validation work without relying on workflow inputs?

Several alternatives:
- **Commit message scanning** — the gate scans recent commit messages for a CHG pattern
- **PR body scanning** — if deploying from a merged PR, scan the PR body
- **Environment variable** — teams set a `CHANGE_TICKET` variable on the Production environment in the UI before deploying
- **External lookup** — the gate calls ServiceNow's API to check if there's an approved change window for this repo/service right now (no ticket number needed)

### How are environment ordering/hierarchy defined?

The hierarchy is configured in [`config.yml`](config.yml). The gate matches environments by **exact name**. If a team's environment name isn't in the config, the gate **auto-approves** (unknown environment = no restrictions).

### What if a team calls their environments different names?

Three approaches:

**A. Standardize names (simplest):** The rollout script creates the environments *for* teams. If they use `environment: QA`, it hits the gate. If they invent their own name, it won't have the gate attached, so it's ungated — but you can detect this with audit automation.

**B. Per-repo config file (most flexible):** Have teams put an `environments.yml` in their `.github/` folder that maps their custom names to standard classifications:

```yaml
environments:
  my-test-env:
    maps_to: testing
  pre-prod:
    maps_to: staging
  prod-us:
    maps_to: production
```

The gate reads this file and maps accordingly.

**C. Fuzzy matching (pragmatic):** The gate pattern-matches: `*prod*` → production rules, `*stag*` or `*uat*` → staging rules, `*qa*` or `*test*` → testing rules. Not perfect but catches 90% of cases.

### What if a team creates their own environment that bypasses the gate?

The gate only fires on environments that have the deployment protection rule attached. If a team creates a rogue `my-prod` environment, it won't have the gate. To catch this:

1. **Audit automation** — periodically scan repos for environments missing the gate and flag/fix them
2. **Required workflows** — use org-level required workflows to ensure certain checks run
3. **OIDC claim restrictions** — if deploying to cloud (Azure/AWS), restrict OIDC tokens to only work from approved environments

### Can this work with OIDC / cloud deployments?

Yes. The gate is GitHub-side and fires *before* the workflow job starts. So even if the job would use OIDC to get Azure/AWS credentials, the gate blocks it before OIDC ever executes. You can use both together:
- **Gate** = "has this SHA been through Dev and QA?"
- **OIDC** = "does this workflow/environment have permission to access the cloud resource?"

### How do we host this in production (not smee.io)?

Any platform that can run a Node.js app and receive HTTPS webhooks:
- **Azure Web App** or **Azure Container Instance**
- **AWS Lambda** (with API Gateway)
- **A VM or container** on your existing infrastructure
- **GitHub Codespaces** (for extended demos)

Update the GitHub App's webhook URL from your smee.io URL to the production URL.
