<?php
namespace App\Models;
use Illuminate\Database\Eloquent\Model;
class Team extends Model
{
    public function members(): HasMany
    {
        return $this->hasMany(Member::class);
    }
    public function projects(): BelongsToMany
    {
        return $this->belongsToMany(Project::class);
    }
}
