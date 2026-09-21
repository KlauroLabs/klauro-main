class webserver {
  package { 'nginx':
    ensure => installed,
  }
}
