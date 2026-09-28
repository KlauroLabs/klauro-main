<?php

namespace App\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/blog')]
final class BlogController extends AbstractController
{
    #[Route('/', name: 'blog_index', methods: ['GET'])]
    #[Route('/rss.xml', name: 'blog_rss', methods: ['GET'])]
    public function index(): Response
    {
        return $this->render('blog/index.html.twig');
    }

    #[Route('/comment/{postSlug}/new', name: 'comment_new', methods: ['POST'])]
    public function commentNew($postSlug): Response
    {
        return $this->render('blog/comment.html.twig');
    }

    #[Route('/legacy', name: 'blog_legacy')]
    public function legacy(): Response
    {
        return $this->render('blog/legacy.html.twig');
    }
}
