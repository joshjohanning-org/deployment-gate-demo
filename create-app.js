const http = require("http");
const fs = require("fs");
const path = require("path");

const ORG = "joshjohanning-org";
const SMEE_URL = "https://smee.io/bCXTUU8xH5wDYGeZ";
const PORT = 9876;
const REPO_DIR = path.join(process.env.HOME, "Repos", "deployment-gate-demo");

const manifest = {
  name: "Deployment Gate Demo",
  url: "https://github.com/joshjohanning-org/deployment-gate-demo",
  hook_attributes: { url: SMEE_URL },
  redirect_url: "http://localhost:" + PORT + "/callback",
  public: false,
  default_permissions: {
    actions: "read",
    deployments: "write",
    metadata: "read",
  },
  default_events: ["deployment_protection_rule"],
};

const html = '<!DOCTYPE html><html><body>' +
  '<h1>Create Deployment Gate GitHub App</h1>' +
  '<p>Click the button to create the GitHub App on ' + ORG + ':</p>' +
  '<form action="https://github.com/organizations/' + ORG + '/settings/apps/new" method="post">' +
  '<input type="hidden" name="manifest" value=\'' + JSON.stringify(manifest) + '\'>' +
  '<button type="submit" style="font-size:24px;padding:20px 40px;cursor:pointer;">Create GitHub App</button>' +
  '</form></body></html>';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:" + PORT);

  if (url.pathname === "/callback") {
    const code = url.searchParams.get("code");
    if (code) {
      try {
        const response = await fetch("https://api.github.com/app-manifests/" + code + "/conversions", {
          method: "POST",
          headers: { Accept: "application/vnd.github+json" },
        });
        const data = await response.json();

        // Save the private key
        const keyPath = path.join(REPO_DIR, "private-key.pem");
        fs.writeFileSync(keyPath, data.pem);

        // Save .env
        const envContent = [
          "APP_ID=" + data.id,
          "PRIVATE_KEY_PATH=./private-key.pem",
          "WEBHOOK_SECRET=" + (data.webhook_secret || ""),
          "PORT=3000",
          "SMEE_URL=" + SMEE_URL,
          "",
        ].join("\n");
        fs.writeFileSync(path.join(REPO_DIR, ".env"), envContent);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>GitHub App Created!</h1><p>App ID: " + data.id + "</p><p>Name: " + data.name + "</p><p>Private key and .env saved. You can close this window.</p>");

        console.log("\n===== APP CREATED =====");
        console.log("App ID: " + data.id);
        console.log("App Name: " + data.name);
        console.log("Slug: " + data.slug);
        console.log("=======================\n");

        setTimeout(() => process.exit(0), 2000);
      } catch (e) {
        res.writeHead(500);
        res.end("Error: " + e.message);
        console.error(e);
      }
    }
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
});

server.listen(PORT, () => {
  console.log("\nOpen this URL in your browser:\n  http://localhost:" + PORT + "\n");
  console.log("Click the button to create the GitHub App.\n");
});
