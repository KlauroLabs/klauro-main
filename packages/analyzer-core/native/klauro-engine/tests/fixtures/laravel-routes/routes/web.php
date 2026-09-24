<?php

use App\Http\Controllers\CallController;
use Illuminate\Support\Facades\Route;

Route::post('calls', [CallController::class, 'store']);
Route::delete('calls/{call}', [CallController::class, 'destroy']);
