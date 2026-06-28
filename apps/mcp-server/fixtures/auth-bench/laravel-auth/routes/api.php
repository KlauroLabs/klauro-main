<?php

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\UserController;

Route::get('/users', [UserController::class, 'index']);
Route::post('/users', [UserController::class, 'store'])->middleware('auth');
Route::delete('/users/{id}', [UserController::class, 'destroy'])->middleware('auth:sanctum');
