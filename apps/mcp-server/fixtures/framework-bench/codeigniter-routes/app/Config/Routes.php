<?php

$routes->get('/', 'Home::index');
$routes->get('users', 'UserController::index');
$routes->post('users', 'UserController::create');

$routes->group('api', function ($routes) {
    $routes->get('items', 'ItemController::index');
    $routes->group('v2', function ($routes) {
        $routes->get('items', 'ItemController::indexV2');
    });
});
