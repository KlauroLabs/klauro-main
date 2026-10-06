<?php

namespace App\Controller;

use Symfony\Component\Routing\Attribute\Route;

#[Route('/profile')]
final class UserController
{
    #[Route('/edit', name: 'user_edit', methods: ['GET', 'POST'])]
    public function edit()
    {
    }

    #[Route('/show', name: 'user_show', methods: ['GET'])]
    public function show()
    {
    }
}
