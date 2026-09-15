deploy() {
  rsync -a . "$1"
}
deploy prod
