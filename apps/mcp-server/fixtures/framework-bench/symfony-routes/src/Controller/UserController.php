<?php

namespace App\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/users')]
class UserController extends AbstractController
{
    #[Route('', methods: ['GET'])]
    public function list(): Response
    {
        return new Response('[]');
    }

    #[Route('', methods: ['POST'])]
    public function create(): Response
    {
        return new Response('', 201);
    }

    #[Route('/{id}', methods: ['DELETE'])]
    public function remove(int $id): Response
    {
        return new Response('', 204);
    }
}
