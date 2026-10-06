<?php
namespace App\Entity;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
class Account
{
    #[ORM\Id]
    #[ORM\Column]
    private int $id;
}
