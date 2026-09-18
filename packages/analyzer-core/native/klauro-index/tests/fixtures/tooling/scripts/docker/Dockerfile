FROM php:8.4
COPY app app
COPY scripts/docker/install-composer.sh /usr/local/bin/install-composer
CMD ["php", "app/serve.php"]
