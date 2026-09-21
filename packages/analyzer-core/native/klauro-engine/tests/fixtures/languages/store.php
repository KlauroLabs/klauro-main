<?php
namespace Fixture;

class Session extends Base {
    private string $identifier;
    private int $started;

    public function close(bool $force): bool {
        if ($force) {
            throw new RuntimeException("forced");
        }
        return $this->persist($this->identifier);
    }

    private function persist(string $id): bool {
        return strlen($id) > 0;
    }
}
