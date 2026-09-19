<?php

namespace App\Traits;

trait Sluggable
{
    public function slug(): string
    {
        return strtolower($this->name);
    }
}
