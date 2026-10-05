package main

import "os/exec"

const workerPath = "../workers/payments/run.js"

func main() {
	exec.Command("node", workerPath).Run()
}
