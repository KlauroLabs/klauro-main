a = Analysis(['main.py'])
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, name='app')
