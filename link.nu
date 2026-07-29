# 链接文件
def main [] {
  if (is-admin) {
    let $kernel_name = (uname | get kernel-name)
    if $kernel_name == "Windows_NT" {
      for e in (open linkfiles.toml | get files) {
        let src = ($e.src | path expand);
        # path expand follows symlinks, so resolve linkto manually
        let linkto = if ($e.linkto | str contains ':\\') or ($e.linkto | str starts-with '\\\\') {
          $e.linkto
        } else {
          $env.PWD | path join $e.linkto
        }
        mkdir -v $'($linkto | path dirname)';
        do -i {
          if ($src | path type) == "dir" {
            mklink /J $linkto $src
          } else {
            mklink $linkto $src
          }
        }
      }
    } else if $kernel_name == "Linux" {
      for e in (open linkfiles.toml | get files) {
        let src = ($e.src | path expand);
        let linkto = if ($e.linkto | str starts-with '/') {
          $e.linkto
        } else {
          $env.PWD | path join $e.linkto
        }
        mkdir -v $'($linkto | path dirname)';
        do -i { ln -s $src $linkto; }
      }
    } else {
      print "Unknown system"
    }
  } else {
    print "Run it as admin."
  }
}

# 添加链接文件路径至配置文件
def "main addPath" [
  src: path # 源文件路径
  linkto: path # 链接至的路径
] {
  if (checkTomlExists) {
    open linkfiles.toml | update files {append {src: $src, linkto: $linkto}} | save -f linkfiles.toml
  } else {
    {"files": [{src: $src, linkto: $linkto}]} | save linkfiles.toml
  }
}

# 删除链接文件
def "main remove" [] {
  if not (checkTomlExists) {
    error make {msg: "linkfiles.toml doesn't exist"}
  }

  if (is-admin) {
      for f in (open linkfiles.toml | get files.linkto) {
        # path expand follows symlinks, so resolve relative paths manually
        let $f = if ($f | str contains ':\\') or ($f | str starts-with '\\\\') {
          $f  # already absolute (C:\... or \\...)
        } else {
          $env.PWD | path join $f  # relative path
        }
        let sym_type = (do -i { $f | path type })
        if $sym_type == "symlink" {
          let $r = ^fsutil reparsepoint delete $f | complete
          if $r.exit_code == 0 {
            do -i { ^cmd /c rmdir $f 2>nul }  # if it was a junction, now an empty directory
            do -i { ^cmd /c del /q $f 2>nul }  # if it was a file symlink, now a regular file
            print $"Remove (ansi green)($f)(ansi reset) successfully"
          } else {
            print -e $"(ansi red)($r.stderr)(ansi reset)"
          }
        } else if ($sym_type != null) {
          print -e $"(ansi red)($f) is not a symlink/junction, skipping(ansi reset)"
        } else {
          print -e $"(ansi yellow)($f) does not exist, skipping(ansi reset)"
        }
      }
  } else {
    print "Run it as admin."
  }

}

def checkTomlExists [] {
  return ("./linkfiles.toml" | path exists)
}
