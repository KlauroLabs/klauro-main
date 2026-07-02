package main

import (
	"github.com/fixture/go-cmd-monorepo/internal/config"
	"github.com/fixture/go-cmd-monorepo/internal/logging"
)

func main() {
	cfg := config.Load()
	logging.Info("server starting on " + cfg.Addr)
}
