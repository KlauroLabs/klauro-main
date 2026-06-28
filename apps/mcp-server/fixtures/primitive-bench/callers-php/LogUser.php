<?php
namespace Shop;
class LogUser {
    function logIt(Logger $l) {
        $l->save();
    }
}
