const http = require('node:http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><body><h1>CommissionWatch</h1><p>Coming soon.</p></body></html>');
});

server.listen(PORT, () => {
  console.log(`CommissionWatch frontend listening on port ${PORT}`);
});

module.exports = server;
