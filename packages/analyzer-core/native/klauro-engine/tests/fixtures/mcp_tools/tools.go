package main

import (
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func listGoToolsHandler() {
}

func registerTools(s *server.MCPServer) {
	s.AddTool(mcp.NewTool("list_go_tools", mcp.WithDescription("Lists tools")), listGoToolsHandler)
}
