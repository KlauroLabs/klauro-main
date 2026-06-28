<?php
namespace Shop;
class Service {
    function persist(Account $a) {
        $a->save();
    }
}
