<?php

class Cache
{
    public function lookup($collection)
    {
        return $collection->get('etag');
    }
}
