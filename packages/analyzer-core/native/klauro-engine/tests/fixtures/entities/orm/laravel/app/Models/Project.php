<?php
namespace App\Models;
class Project extends BaseModel
{
    public function teams()
    {
        return $this->belongsToMany(Team::class);
    }
}
