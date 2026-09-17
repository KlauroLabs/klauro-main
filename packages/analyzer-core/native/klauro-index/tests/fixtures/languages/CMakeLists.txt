project(demo)

add_library(parser STATIC src/parser.c)

add_executable(cli src/main.c)

function(configure_target target)
  target_link_libraries(${target} parser)
endfunction()
