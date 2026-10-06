<?php
namespace App\Entity;
use Doctrine\ORM\Mapping as ORM;

/**
 * @ORM\Entity
 */
class Invoice
{
    /** @ORM\Column(type="string") */
    private string $number;

    /**
     * @ORM\ManyToOne(targetEntity="Client", inversedBy="invoices")
     */
    private Client $client;
}
