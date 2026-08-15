

























const mode = process.argv[2];
if (mode === '__mcp_server') {




  process.argv.splice(2, 1);
  require('./index');
} else {
  require('./installed-cli');
}
