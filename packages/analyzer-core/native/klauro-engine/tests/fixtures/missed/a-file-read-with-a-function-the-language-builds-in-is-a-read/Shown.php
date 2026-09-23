<?php

final class Shown
{
    public function lines(string $path): array
    {
        $held = \file_get_contents($path);
        return explode("\n", $held);
    }
}
