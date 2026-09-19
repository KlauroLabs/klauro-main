<?php

namespace App\Models;

use App\Traits\Sluggable;

class Contact
{
    use Sluggable;

    public string $name = '';

    public function label(): string
    {
        return $this->slug();
    }
}
