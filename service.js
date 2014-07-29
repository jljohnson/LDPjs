module.exports = function(app, db, env) {
	var url = require('url');
	var ldp = require('./vocab/ldp.js');			// LDP vocabulary
	var rdf = require('./vocab/rdf.js');			// RDF vocabulary
	var media = require('./media.js');				// media types
	var turtle = require('./turtle.js');
	var jsonld = require('./jsonld.js');
	var crypto = require('crypto');					// for MD5 (ETags)

	// create root container if it doesn't exist
	db.get(env.ldpBase, function(err, document) {
		if (err) {
			console.log(err.stack);
			return;
		}

		if (!document) {
			createRootContainer();
		}
	});

	// route any requests matching /r/*
	var resource = app.route(env.context + '*');
	resource.all(function(req, res, next) {
		// all responses should have Link: <ldp:Resource> rel=type
		res.links({
			type: ldp.Resource,
			describedby: env.appBase + '/constraints.html'
		});
		next();
	});

	function get(req, res, includeBody) {
		res.set('Vary', 'Accept');
		db.get(req.fullURL, function(err, document) {
			if (err) {
				console.log(err.stack);
				res.send(500);
				return;
			}

			if (!document) {
				res.send(404);
				return;
			}

			if (document.deleted) {
				res.send(410);
				return;
			}

			var format;
			if (req.accepts(media.turtle)) {
				format = turtle.serialize;
			} else if (req.accepts(media.jsonld) || req.accepts(media.json)) {
				format = jsonld.serialize;
			} else {
				res.send(406);
				return;
			}

			addHeaders(res, document.interactionModel);
			addContainment(req, document, function(err) {
				if (err) {
					console.log(err.stack);
					res.send(500);
					return;
				}

				format(document.triples, function(err, contentType, content) {
					if (err) {
						res.send(500);
					} else {
						var eTag = getETag(content);
						if (req.get('If-None-Match') === eTag) {
							res.send(304);
							return;
						}

						res.writeHead(200, { 'ETag': eTag, 'Content-Type': contentType });
						if (includeBody) {
							res.end(new Buffer(content), 'utf-8');
						} else {
							res.end();
						}
					}
				});
			});
		});
	}

	resource.get(function(req, res, next) {
		console.log('GET ' + req.path);
		get(req, res, true);
	});

	resource.head(function(req, res, next) {
		console.log('HEAD ' + req.path);
		get(req, res, false);
	});

	resource.put(function(req, res, next) {
		console.log('PUT ' + req.path);
		var parse, format;
		if (req.is(media.turtle)) {
			parse = turtle.parse;
			format = turtle.serialize;
		} else if (req.is(media.jsonld) || req.is(media.json)) {
			parse = jsonld.parse;
			format = jsonld.serialize;
		} else {
			res.send(415);
			return;
		}

		parse(req, req.fullURL, function(err, triples, interactionModel) {
			if (err) {
				res.send(400);
				return;
			}

			// get the resource to check if it exists and check its ETag
			db.get(req.fullURL, function(err, original) {
				if (original) {
					if (original.deleted) {
						res.send(410);
						return;
					}

					// update
					var ifMatch = req.get('If-Match');
					if (!ifMatch) {
						res.send(428);
						return;
					}

					// add containment triples if necessary to calculate the correct ETag
					// for containers
					addContainment(req, original, function(err) {
						if (err) {
							console.log(err.stack);
							res.send(500);
							return;
						}

						// calculate the ETag from the text/turtle representation
						format(original.triples, function(err, contentType, content) {
							if (err) {
								console.log(err.stack);
								res.send(500);
								return;
							}

							var eTag = getETag(content);
							if (ifMatch !== eTag) {
								res.send(412);
								return;
							}

							if (modifiesContainment(original, triples)) {
								res.send(409);
								return;
							}

							// remove any containment triples from the container itself as we
							// store containment as metadata with the resources themselves
							var filteredTriples = removeContainment(original.interactionModel, triples);

							// we don't support changing from RDFSource to container or back
							// use the original interaction model
							db.put(req.fullURL, null, original.interactionModel, filteredTriples, function(err) {
								if (err) {
									console.log(err.stack);
									res.send(500);
									return;
								}

								res.send(original ? 204 : 201)
							});
						});
					});
				} else {
					// create
					db.put(req.fullURL, null, interactionModel, triples, function(err) {
						if (err) {
							console.log(err.stack);
							res.send(500);
							return;
						}

						res.send(original ? 204 : 201)
					});
				}
			});
		});
	});

	resource.post(function(req, res, next) {
		console.log('POST ' + req.path);
		db.isContainer(req.fullURL, function(err, result) {
			if (err) {
				console.log(err.stack);
				res.send(500);
				return;
			}

			if (!result) {
				res.send(409);
				return;
			}

			var parse;
			if (req.is(media.turtle)) {
				parse = turtle.parse;
			} else if (req.is(media.jsonld) || req.is(media.json)) {
				parse = jsonld.parse;
			} else {
				res.send(415);
				return;
			}

			assignURI(req.fullURL, req.get('Slug'), function(err, loc) {
				if (err) {
					console.log(err.stack);
					res.send(500);
					return;
				}

				parse(req, loc, function(err, triples, interactionModel) {
					if (err) {
						// allow the URI to be used again
						db.releaseURI(loc);
						res.send(400);
						return;
					}

					addHeaders(res, interactionModel);
		   
					db.put(loc, req.fullURL, interactionModel, triples, function(err) {
						if (err) {
							console.log(err.stack);
							res.send(500);
							return;
						}
					
						res.location(loc).send(201);	
					});
				});
			});
		});
	});

	resource.delete(function(req, res, next) {
		console.log('DELETE: ' + req.path);
		db.remove(req.fullURL, function(err, result) {
			if (err) {
				console.log(err.stack);
				res.send(500);
				return;
			}

			res.send(result ? 204 : 404);
		});
	});

	resource.options(function(req, res, next) {
		db.get(req.fullURL, function(err, document) {
			if (err) {
				console.log(err.stack);
				res.send(500);
				return;
			}

			if (!document) {
				res.send(404);
				return;
			}

			if (document.deleted) {
				res.send(410);
				return;
			}

			addHeaders(res, document.interactionModel);
			res.send(200);
		});
	});

	function createRootContainer() {
		var triples = [{
			subject: env.ldpBase,
			predicate: rdf.type,
			object: ldp.Resource
		}, {
			subject: env.ldpBase,
			predicate: rdf.type,
			object: ldp.RDFSource
		}, {
			subject: env.ldpBase,
			predicate: rdf.type,
			object: ldp.Container
		}, {
			subject: env.ldpBase,
			predicate: rdf.type,
			object: ldp.BasicContainer
		}, {
		   	subject: env.ldpBase,
			predicate: 'http://purl.org/dc/terms/title',
    		object: '"LDP.js root container"'
		}];

		db.put(env.ldpBase, null, ldp.BasicContainer, triples, function(err) {
			if (err) {
				console.log(err.stack);
			}
		});
	}

	function getETag(content) {
		return 'W/"' + crypto.createHash('md5').update(content).digest('hex') + '"';
	}

	function addHeaders(res, interactionModel) {
		res.links({ type: ldp.RDFSource });
		var allow = 'GET,HEAD,PUT,DELETE,OPTIONS';
		if (interactionModel === ldp.BasicContainer) {
			res.links({
				type: ldp.BasicContainer
			});

			allow += ',POST';
			res.set('Accept-Post', media.turtle + ',' + media.jsonld);
		}

		res.set('Allow', allow);
	}

	// insert containment triples if necessary
	function addContainment(req, document, callback) {
		if (document.interactionModel === ldp.BasicContainer) {
			db.getContainment(req.fullURL, function(err, containment) {
				if (containment) {
					containment.forEach(function(resource) {
						document.triples.push({
							subject: req.fullURL,
							predicate: ldp.contains,
							object: resource
						});
					});
				}
				callback(err);
			});	
		} else {
			callback();
		}
	}

	function addPath(uri, path) {
		uri = uri.split("?")[0].split("#")[0];
	    if (uri.substr(-1) !== '/') {
			uri += '/';
		}

		// remove special characters from the string (e.g., '/', '..', '?')
		var lastSegment = path.replace(/[^\w\s\-_]/gi, '');
		return uri + encodeURIComponent(lastSegment);
	}

	function uniqueURI(container, callback) {
		var candidate = addPath(container, 'res' + Date.now());
		db.reserveURI(candidate, function(err) {
			callback(err, candidate);
		});
	}

	function assignURI(container, slug, callback) {
		if (slug) {
			var candidate = addPath(container, slug);
			db.reserveURI(candidate, function(err) {
				if (err) {
					uniqueURI(container, callback);
				} else {
					callback(null, candidate);
				}
			});
		} else {
			uniqueURI(container, callback);
		}
	}

	function modifiesContainment(originalDocument, newTriples) {
		if (originalDocument.interactionModel !== ldp.BasicContainer) {
			return false;
		}

		var originalTotal = 0, newTotal = 0, originalContainment = {};
		originalDocument.triples.forEach(function(triple) {
			if (triple.subject === originalDocument.name && triple.predicate === ldp.contains) {
				originalContainment[triple.object] = 1;
				originalTotal++;
			}
		});

		for (var i = 0; i < newTriples.length; i++) {
			var triple = newTriples[i];
			if (triple.subject === originalDocument.name && triple.predicate === ldp.contains) {
				if (!originalContainment[triple.object]) {
					return true;
				}
				newTotal++;
			}
		}

		return originalTotal !== newTotal;
	}

	function removeContainment(interactionModel, triples) {
		if (interactionModel === ldp.BasicContainer) {
			return triples.filter(function(triple) {
				return triple.predicate !== ldp.contains;
			});
		}

		return triples;
	}
};
