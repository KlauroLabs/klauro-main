class Toolbelt {
  tool(name: string, handler: () => void) {
    handler();
  }
}

const belt = new Toolbelt();

belt.tool('not_an_mcp_tool', () => {
  console.log('just a regular method named tool');
});
