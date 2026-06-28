const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express(); // nosemgrep: javascript.express.security.audit.express-check-csurf-middleware-usage.express-check-csurf-middleware-usage -- GET-only 503 maintenance server; no cookie auth or state-changing routes.
const PORT = process.env.PORT || 4100;
const HOST = process.env.HOST || '0.0.0.0';

// Read the maintenance HTML file
const maintenanceHtmlPath = '/home/vendure/damned/maintenance.html';
let maintenanceHtml;

try {
    maintenanceHtml = fs.readFileSync(maintenanceHtmlPath, 'utf8');
} catch (error) {
    console.error('Error reading maintenance.html:', error);
    maintenanceHtml = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Under Maintenance</title>
        <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
            h1 { color: #333; }
        </style>
    </head>
    <body>
        <h1>🚧 Under Maintenance</h1>
        <p>We're currently performing maintenance. Please check back soon.</p>
    </body>
    </html>
    `;
}

// Serve maintenance page for ALL routes
app.get('*', (req, res) => {
    res.status(503).send(maintenanceHtml);
});

app.listen(PORT, HOST, () => {
    console.log(`🚧 Maintenance mode active on http://${HOST}:${PORT}/`);
});
