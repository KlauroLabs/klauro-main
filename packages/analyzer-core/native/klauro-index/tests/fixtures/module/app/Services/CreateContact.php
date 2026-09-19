<?php

namespace App\Services;

use App\Models\Contact;
use Illuminate\Support\Facades\DB;

class CreateContact
{
    public function execute(): Contact
    {
        DB::table('contacts')->insert([]);

        return new Contact();
    }
}
