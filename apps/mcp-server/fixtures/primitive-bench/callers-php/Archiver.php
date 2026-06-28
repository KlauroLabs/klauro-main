<?php
namespace Shop;
class Archiver {
    function archive(Account $a) {
        $a->save();
    }
}
