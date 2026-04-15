const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const yaml = require("js-yaml");
const { Octokit } = require("octokit");

// Load configuration
require("dotenv").config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const APP_ID = process.env.APP_ID;
const PRIVATE_KEY_PATH = process.env.PRIVATE_KEY_PATH || "./private-key.pem";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Load environment hierarchy config
const config = yaml.load(fs.readFileSync("./config.yml", "utf8"));

// ─────────────────────────────────────────────────────────────────────────────
// Mock ServiceNow API
// ─────────────────────────────────────────────────────────────────────────────

const MOCK_TICKETS = {
  CHG0012345: {
    number: "CHG0012345",
    state: "implement",
    short_description: "Deploy app v1.2.0 to production",
    approval: "approved",
    assigned_to: "deploy-team",
  },
  CHG0099999: {
    number: "CHG0099999",
    state: "new",
    short_description: "Pending change",
    approval: "not yet requested",
    assigned_to: "deploy-team",
  },
};

app.get("/api/servicenow/ticket/:number", (req, res) => {
  const ticket = MOCK_TICKETS[req.params.number];
  if (ticket) {
    res.json({ result: ticket });
  } else if (/^CHG\d{7}$/.test(req.params.number)) {
    // Valid format but not in our mock data — treat as approved for demo
    res.json({
      result: {
        number: req.params.number,
        state: "implement",
        short_description: "Auto-generated mock ticket",
        approval: "approved",
        assigned_to: "deploy-team",
      },
    });
  } else {
    res.status(404).json({ error: "Invalid ticket format. Expected CHG followed by 7 digits." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Webhook signature verification
// ─────────────────────────────────────────────────────────────────────────────

function verifyWebhookSignature(req) {
  if (!WEBHOOK_SECRET) return true; // Skip in dev if not configured
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) return false;
  const hmac = crypto.createHmac("sha256", WEBHOOK_SECRET);
  hmac.update(JSON.stringify(req.body));
  const expected = `sha256=${hmac.digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate GitHub App JWT and installation token
// ─────────────────────────────────────────────────────────────────────────────

function generateJWT() {
  const privateKey = fs.readFileSync(PRIVATE_KEY_PATH, "utf8");
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iat: now - 60, exp: now + 600, iss: APP_ID },
    privateKey,
    { algorithm: "RS256" }
  );
}

async function getInstallationToken(installationId) {
  const jwtToken = generateJWT();
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        Accept: "application/vnd.github+json",
      },
    }
  );
  const data = await response.json();
  return data.token;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check if prior environment has a deployment for this ref/SHA
// ─────────────────────────────────────────────────────────────────────────────

async function checkPriorEnvironmentDeployment(octokit, owner, repo, priorEnv, headSha) {
  try {
    // List deployments for the prior environment
    const { data: deployments } = await octokit.rest.repos.listDeployments({
      owner,
      repo,
      environment: priorEnv,
      sha: headSha,
      per_page: 10,
    });

    if (deployments.length === 0) {
      return {
        passed: false,
        message: `No deployment of SHA \`${headSha.slice(0, 7)}\` found in environment '${priorEnv}'. This exact commit/ref must be deployed to '${priorEnv}' before it can be promoted.`,
      };
    }

    // Check if any of the matching deployments has a success status
    for (const deployment of deployments) {
      const { data: statuses } = await octokit.rest.repos.listDeploymentStatuses({
        owner,
        repo,
        deployment_id: deployment.id,
        per_page: 1,
      });
      if (statuses.length > 0 && statuses[0].state === "success") {
        return {
          passed: true,
          message: `Found successful deployment of SHA \`${headSha.slice(0, 7)}\` to '${priorEnv}' (deployment #${deployment.id}).`,
        };
      }
    }

    return {
      passed: false,
      message: `SHA \`${headSha.slice(0, 7)}\` has deployments to '${priorEnv}' but none with a success status. The deployment must complete successfully before promotion.`,
    };
  } catch (error) {
    console.error("Error checking deployments:", error.message);
    return { passed: false, message: `Error checking deployments: ${error.message}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validate ServiceNow change ticket
// ─────────────────────────────────────────────────────────────────────────────

async function validateChangeTicket(runId, owner, repo, octokit, webhookPayload) {
  // Try to find the change ticket from multiple sources:
  // 1. The deployment payload (set by the workflow)
  // 2. The workflow run inputs (if accessible)
  try {
    let ticketNumber = null;

    // Source 1: Check the deployment payload for a change ticket
    const deploymentPayload = webhookPayload?.deployment?.payload || {};
    if (typeof deploymentPayload === 'object') {
      ticketNumber = deploymentPayload.change_ticket || deploymentPayload.ticket || null;
    }

    // Source 2: Check the workflow run display_title or head_commit message
    if (!ticketNumber) {
      const { data: run } = await octokit.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: parseInt(runId),
      });

      // Check workflow dispatch inputs
      const inputs = run.inputs || {};
      ticketNumber =
        inputs.change_ticket ||
        inputs.snow_ticket ||
        inputs.ticket ||
        inputs.change_number ||
        null;

      // Also check the display title for a CHG pattern
      if (!ticketNumber && run.display_title) {
        const match = run.display_title.match(/CHG\d{7}/);
        if (match) ticketNumber = match[0];
      }
    }

    // Source 3: Check environment variables set in the deployment
    if (!ticketNumber && webhookPayload?.deployment?.description) {
      const match = webhookPayload.deployment.description.match(/CHG\d{7}/);
      if (match) ticketNumber = match[0];
    }

    if (!ticketNumber) {
      return {
        passed: false,
        message:
          "No ServiceNow change ticket provided. Production deployments require a valid change ticket (e.g., CHG0012345) in the workflow dispatch inputs.",
      };
    }

    // Validate format
    if (!/^CHG\d{7}$/.test(ticketNumber)) {
      return {
        passed: false,
        message: `Invalid ticket format: '${ticketNumber}'. Expected format: CHG followed by 7 digits (e.g., CHG0012345).`,
      };
    }

    // Call mock ServiceNow API to validate
    const snowResponse = await fetch(
      `http://localhost:${PORT}/api/servicenow/ticket/${ticketNumber}`
    );
    const snowData = await snowResponse.json();

    if (!snowResponse.ok) {
      return { passed: false, message: `ServiceNow validation failed: ${snowData.error}` };
    }

    const ticket = snowData.result;
    if (ticket.approval !== "approved") {
      return {
        passed: false,
        message: `Change ticket ${ticketNumber} is not approved (status: ${ticket.approval}). Approval required before production deployment.`,
      };
    }

    return {
      passed: true,
      message: `ServiceNow ticket ${ticketNumber} validated: "${ticket.short_description}" (state: ${ticket.state}, approval: ${ticket.approval}).`,
    };
  } catch (error) {
    console.error("Error validating change ticket:", error.message);
    return { passed: false, message: `Error validating change ticket: ${error.message}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Respond to GitHub (approve or reject the deployment)
// ─────────────────────────────────────────────────────────────────────────────

async function respondToGitHub(octokit, owner, repo, runId, envName, state, comment) {
  try {
    await octokit.request("POST /repos/{owner}/{repo}/actions/runs/{run_id}/deployment_protection_rule", {
      owner,
      repo,
      run_id: parseInt(runId),
      environment_name: envName,
      state,
      comment,
    });
    console.log(`  Response sent: ${state}`);
  } catch (error) {
    console.error(`  Error responding to GitHub: ${error.message}`);
    // Try the callback URL approach as fallback
    try {
      const payload_body = { state, comment, environment_name: envName };
      const callbackUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/deployment_protection_rule`;
      const token = octokit.auth;
      const resp = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          Authorization: `token ${typeof token === 'string' ? token : ''}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload_body),
      });
      if (resp.ok) {
        console.log(`  Response sent via fallback: ${state}`);
      } else {
        const body = await resp.text();
        console.error(`  Fallback also failed: ${resp.status} ${body}`);
      }
    } catch (e2) {
      console.error(`  Fallback error: ${e2.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main webhook handler
// ─────────────────────────────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  const event = req.headers["x-github-event"];

  // Only handle deployment protection rule events
  if (event !== "deployment_protection_rule") {
    console.log(`Ignoring event: ${event}`);
    return res.status(200).send("OK");
  }

  // Verify signature
  if (!verifyWebhookSignature(req)) {
    console.error("Invalid webhook signature");
    return res.status(401).send("Invalid signature");
  }

  const payload = req.body;
  const action = payload.action;

  if (action !== "requested") {
    console.log(`Ignoring action: ${action}`);
    return res.status(200).send("OK");
  }

  const environment = payload.environment;
  const deployment = payload.deployment;
  const repo = payload.repository;
  const installationId = payload.installation.id;
  const runId = payload.deployment_callback_url
    ? payload.deployment_callback_url.match(/runs\/(\d+)/)?.[1]
    : null;

  console.log("\n" + "═".repeat(60));
  console.log("Deployment Protection Rule - Request Received");
  console.log("═".repeat(60));
  console.log(`  Repository:  ${repo.full_name}`);
  console.log(`  Environment: ${environment}`);
  console.log(`  SHA:         ${deployment?.sha?.slice(0, 7) || "unknown"}`);
  console.log(`  Run ID:      ${runId || "unknown"}`);
  console.log("");

  // Respond immediately to webhook
  res.status(200).send("OK");

  // Get installation token
  const token = await getInstallationToken(installationId);
  const octokit = new Octokit({ auth: token });

  const owner = repo.owner.login;
  const repoName = repo.name;
  const envConfig = config.environments[environment];

  // If this environment isn't in our config, auto-approve
  if (!envConfig) {
    console.log(`  Environment '${environment}' not in config — auto-approving`);
    await respondToGitHub(octokit, owner, repoName, runId, environment, "approved",
      `Environment '${environment}' is not configured in the deployment gate. Auto-approved.`);
    return;
  }

  const checks = [];
  let allPassed = true;

  // ── Check 1: Prior environment deployment ──
  if (envConfig.requires_prior) {
    console.log(`  Check 1: Prior environment '${envConfig.requires_prior}' deployment...`);
    const priorCheck = await checkPriorEnvironmentDeployment(
      octokit, owner, repoName, envConfig.requires_prior, deployment?.sha || ""
    );
    checks.push({ name: "Prior Environment", ...priorCheck });
    if (!priorCheck.passed) allPassed = false;
    console.log(`    ${priorCheck.passed ? "PASS" : "FAIL"}: ${priorCheck.message}`);
  } else {
    checks.push({
      name: "Prior Environment",
      passed: true,
      message: "No prior environment required (first environment in chain).",
    });
    console.log("  Check 1: No prior environment required — PASS");
  }

  // ── Check 2: ServiceNow change ticket ──
  if (envConfig.requires_change_ticket) {
    console.log("  Check 2: ServiceNow change ticket validation...");
    const ticketCheck = await validateChangeTicket(runId, owner, repoName, octokit, payload);
    checks.push({ name: "ServiceNow Ticket", ...ticketCheck });
    if (!ticketCheck.passed) allPassed = false;
    console.log(`    ${ticketCheck.passed ? "PASS" : "FAIL"}: ${ticketCheck.message}`);
  } else {
    checks.push({
      name: "ServiceNow Ticket",
      passed: true,
      message: "Change ticket not required for this environment.",
    });
    console.log("  Check 2: Change ticket not required — PASS");
  }

  // ── Build response comment ──
  const statusEmoji = allPassed ? "approved" : "rejected";
  let comment = `## Deployment Gate ${allPassed ? "Approved" : "Rejected"}\n\n`;
  comment += `**Environment:** ${environment}\n`;
  comment += `**Repository:** ${repo.full_name}\n\n`;
  comment += "| Check | Status | Details |\n|---|---|---|\n";
  for (const check of checks) {
    comment += `| ${check.name} | ${check.passed ? "PASS" : "FAIL"} | ${check.message} |\n`;
  }

  if (!allPassed) {
    comment += "\n**Action required:** Fix the failing checks above before this deployment can proceed.";
  }

  console.log("");
  console.log(`  Final decision: ${statusEmoji.toUpperCase()}`);
  console.log("═".repeat(60));

  await respondToGitHub(octokit, owner, repoName, runId, environment, statusEmoji, comment);
});

// ─────────────────────────────────────────────────────────────────────────────
// Health check & info
// ─────────────────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    app: "deployment-gate-demo",
    description: "Custom Deployment Protection Rule for GitHub Actions",
    status: "running",
    endpoints: {
      webhook: "POST /webhook",
      health: "GET /health",
      servicenow_mock: "GET /api/servicenow/ticket/:number",
    },
    config: {
      environments: Object.keys(config.environments),
      app_id: APP_ID || "not configured",
    },
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start server (with optional smee.io proxy)
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║       Deployment Gate - Custom Protection Rule          ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`  Server:      http://localhost:${PORT}`);
  console.log(`  Webhook:     http://localhost:${PORT}/webhook`);
  console.log(`  Mock SNOW:   http://localhost:${PORT}/api/servicenow/ticket/:number`);
  console.log(`  App ID:      ${APP_ID || "not configured"}`);
  console.log("");

  // Start smee.io proxy if configured
  if (process.env.SMEE_URL) {
    try {
      const SmeeClient = require("smee-client");
      const smee = new SmeeClient({
        source: process.env.SMEE_URL,
        target: `http://localhost:${PORT}/webhook`,
        logger: { info: () => {}, error: console.error },
      });
      smee.start();
      console.log(`  Smee proxy:  ${process.env.SMEE_URL}`);
      console.log(`               → http://localhost:${PORT}/webhook`);
    } catch (e) {
      console.log("  Smee proxy:  not started (smee-client not available)");
    }
  } else {
    console.log("  Smee proxy:  not configured (set SMEE_URL in .env)");
  }

  console.log("");
  console.log("  Environment hierarchy:");
  for (const [name, env] of Object.entries(config.environments)) {
    const prior = env.requires_prior ? `requires ${env.requires_prior}` : "no prior required";
    const ticket = env.requires_change_ticket ? "+ change ticket" : "";
    console.log(`    ${env.order}. ${name} (${prior} ${ticket})`);
  }
  console.log("");
  console.log("  Waiting for webhook events...");
  console.log("");
});
