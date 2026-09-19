package com.demo.app;

import static com.demo.text.Utils.slugify;

public class Page {
    public String render(String title) {
        return slugify(title);
    }
}
