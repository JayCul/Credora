const express = require("express");

/// A minimal HTTP server whose only job is to make this background WhatsApp process
/// look like a "Web Service" to hosts that require one (Render's free tier has no
/// Background Worker option at all, only Web Services, which must bind a port and
/// answer HTTP). It doubles as the endpoint an external uptime pinger hits every
/// few minutes to stop a free-tier instance from spinning down after 15 minutes of
/// no traffic. See README's "Deploying to Render" section for what this does and
/// does not solve, most importantly it does NOT make local disk persistent.
function startHealthServer(getStatus) {
  const app = express();
  const port = process.env.PORT || 3001;

  app.get("/", (req, res) => res.json({ ok: true, ...getStatus() }));
  app.get("/health", (req, res) => res.json({ ok: true, ...getStatus() }));

  app.listen(port, () => {
    console.log(`Health check server on port ${port} (keeps Render's free tier from sleeping when pinged)`);
  });
}

module.exports = { startHealthServer };
