function! s:Greet(name) abort
  echo 'hello ' . a:name
endfunction

command! -nargs=1 Greet call s:Greet(<q-args>)
