<?php

use Slim\Factory\AppFactory;

$app = AppFactory::create();

$app->get('/users', [UserController::class, 'index']);
$app->post('/users', 'UserController::create');

$app->group('/api', function ($group) {
    $group->get('/items', [UserController::class, 'items']);
    $group->group('/v2', function ($group) {
        $group->get('/items', [UserController::class, 'itemsV2']);
    });
});
