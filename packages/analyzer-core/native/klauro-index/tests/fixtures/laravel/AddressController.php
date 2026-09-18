<?php

namespace App\Http\Controllers;

class AddressController
{
    public function index()
    {
        return $this->render('addresses');
    }

    public function store($address)
    {
        return $address;
    }

    private function render($view)
    {
        return $view;
    }
}
