from .models import Tag


def tagged(session, name):
    return session.query(Tag).filter_by(name=name).all()


def counted(session):
    return session.query(Tag).count()
