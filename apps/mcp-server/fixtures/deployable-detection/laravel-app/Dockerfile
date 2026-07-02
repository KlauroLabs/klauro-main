# Single Dockerfile for the Laravel app.
FROM php:8.2-fpm
WORKDIR /var/www
COPY composer.json ./
RUN composer install --no-dev
COPY . .
EXPOSE 9000
CMD ["php-fpm"]
