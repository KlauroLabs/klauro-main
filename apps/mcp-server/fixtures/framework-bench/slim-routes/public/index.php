<?php

use Slim\Factory\AppFactory;
use App\Controller\UserController;
use App\Middleware\AuthMiddleware;

require __DIR__ . '/../vendor/autoload.php';

$app = AppFactory::create();

$app->get('/health', function ($request, $response) {
    return $response;
});

$app->get('/users', [UserController::class, 'index']);
$app->post('/users', [UserController::class, 'create'])->add(new AuthMiddleware());

$app->group('/api', function ($group) {
    $group->get('/items', [UserController::class, 'items']);
    $group->group('/v2', function ($group) {
        $group->get('/items', [UserController::class, 'itemsV2']);
    });
});

$app->run();
