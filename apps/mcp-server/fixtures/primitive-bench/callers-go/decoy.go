package shop

type Logger struct{}

func (l *Logger) Save() {}

func logIt(l *Logger) {
	l.Save()
}
