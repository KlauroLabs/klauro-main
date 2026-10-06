<?php
namespace App\Entity;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'clients')]
class Client
{
    #[ORM\Id]
    #[ORM\Column(type: 'integer')]
    private int $id;

    /** @var Collection<int, Invoice> */
    #[ORM\OneToMany(mappedBy: 'client', targetEntity: Invoice::class)]
    private Collection $invoices;

    #[ORM\OneToOne(targetEntity: Account::class)]
    private ?Account $account = null;
}
