<?php

use App\Http\Controllers\AddressController;

Route::get('addresses', [AddressController::class, 'index']);
Route::post('/addresses/{address}', [AddressController::class, 'store']);
