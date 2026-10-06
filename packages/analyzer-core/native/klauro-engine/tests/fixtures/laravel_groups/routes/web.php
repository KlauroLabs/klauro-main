<?php

use App\Http\Controllers\VaultController;
use Illuminate\Support\Facades\Route;

Route::middleware(['auth'])->group(function () {
    Route::prefix('vaults')->group(function () {
        Route::get('', [VaultController::class, 'index']);
        Route::post(
            '',
            [VaultController::class, 'store']
        );
        Route::get('{vault}', [VaultController::class, 'show']);
        Route::middleware('can:x')->prefix('{vault}')->group(function () {
            Route::get('edit', [VaultController::class, 'edit']);
        });
    });
    Route::apiResource('items', VaultController::class)->only(['index', 'show']);
    Route::resource('photos', VaultController::class);
});
