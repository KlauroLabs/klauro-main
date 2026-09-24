<?php

namespace App\Http\Controllers;

class CallController extends Controller
{
    public function store()
    {
        return response()->json([]);
    }

    public function destroy()
    {
        return response()->noContent();
    }
}
