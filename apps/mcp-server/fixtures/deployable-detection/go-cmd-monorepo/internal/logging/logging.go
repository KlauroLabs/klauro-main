package logging

import "log"

func Info(msg string) {
	log.Println("[INFO]", msg)
}
