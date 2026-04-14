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

## Links

- [Creating custom deployment protection rules](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/creating-custom-deployment-protection-rules)
- [Configuring custom deployment protection rules](https://docs.github.com/en/actions/deployment/protecting-deployments/configuring-custom-deployment-protection-rules)
- [Smee.io webhook proxy](https://smee.io)
