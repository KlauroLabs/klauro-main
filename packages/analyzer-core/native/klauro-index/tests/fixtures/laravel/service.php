<?php

namespace App\Services;

class Mailer
{
    public function deliver($message)
    {
        return $message;
    }
}

class Notifier
{
    public function notify(Mailer $mailer, $message)
    {
        return $mailer->deliver($message);
    }
}
